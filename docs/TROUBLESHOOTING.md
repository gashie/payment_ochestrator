# Orchestrator Troubleshooting & Debugging Guide

## Table of Contents
1. [Quick Diagnostic Commands](#quick-diagnostic-commands)
2. [Flow Status Issues](#flow-status-issues)
3. [Callback Issues](#callback-issues)
4. [Database Column Errors](#database-column-errors)
5. [Step Execution Issues](#step-execution-issues)
6. [API Call Failures](#api-call-failures)
7. [Transform Issues](#transform-issues)
8. [Condition/Check Step Issues](#conditioncheck-step-issues)
9. [Job Queue Issues](#job-queue-issues)
10. [Common Error Messages](#common-error-messages)

---

## Quick Diagnostic Commands

### Check Flow Instance Status
```sql
-- Get flow instance details
SELECT
    fi.id,
    fi.session_id,
    fi.tracking_number,
    fi.status,
    fi.last_error,
    fi.current_step_id,
    fs.step_code,
    fs.step_type,
    fi.created_at,
    fi.completed_at
FROM flow_instances fi
LEFT JOIN flow_steps fs ON fi.current_step_id = fs.id
WHERE fi.session_id = 'YOUR_SESSION_ID';
```

### Check Step Executions for a Flow
```sql
SELECT
    se.status,
    fs.step_code,
    fs.step_type,
    se.error_message,
    (se.api_response::json)->>'actionCode' as action_code,
    se.started_at,
    se.completed_at
FROM step_executions se
JOIN flow_steps fs ON se.step_id = fs.id
WHERE se.flow_instance_id = 'YOUR_INSTANCE_ID'
ORDER BY se.started_at;
```

### Check Expected Callbacks
```sql
SELECT
    id,
    session_id,
    status,
    expected_by,
    received_at,
    created_at
FROM expected_callbacks
WHERE flow_instance_id = 'YOUR_INSTANCE_ID';
```

### Check Received Callbacks
```sql
SELECT
    id,
    session_id,
    action_code,
    processed,
    matched_to_instance_id,
    created_at
FROM received_callbacks
WHERE session_id = 'YOUR_SESSION_ID';
```

### Check Job Queue
```sql
SELECT
    id,
    job_type,
    status,
    error_message,
    created_at,
    started_at
FROM job_queue
WHERE status != 'COMPLETED'
ORDER BY created_at DESC
LIMIT 20;
```

---

## Flow Status Issues

### Scenario 1: Flow Stuck in `PENDING` Status

**Symptoms:**
- Flow instance created but never progresses
- No step executions found
- Status remains `PENDING`

**Diagnosis:**
```sql
-- Check if job was created
SELECT * FROM job_queue
WHERE payload::text LIKE '%YOUR_INSTANCE_ID%'
ORDER BY created_at DESC;

-- Check job status
SELECT status, error_message FROM job_queue
WHERE id = 'JOB_ID';
```

**Possible Causes & Solutions:**

| Cause | Solution |
|-------|----------|
| Background jobs not running | Restart the orchestrator service |
| Job failed to be created | Check `processController.js` for errors |
| Job stuck in processing | Reset job status or restart service |

**Manual Fix:**
```sql
-- Create a new job to process the flow
INSERT INTO job_queue (job_type, payload, status, priority)
VALUES ('EXECUTE_FLOW', '{"flowInstanceId": "YOUR_INSTANCE_ID"}', 'PENDING', 1);
```

---

### Scenario 2: Flow Stuck in `WAITING_CALLBACK` Status

**Symptoms:**
- Flow progressed but stopped at an API_CALL step
- Expected callback exists but not matched
- Flow never continues

**Diagnosis:**
```sql
-- Check expected callback
SELECT
    ec.id,
    ec.status,
    ec.expected_by,
    ec.received_at,
    fs.step_code
FROM expected_callbacks ec
JOIN step_executions se ON ec.step_execution_id = se.id
JOIN flow_steps fs ON se.step_id = fs.id
WHERE ec.flow_instance_id = 'YOUR_INSTANCE_ID';

-- Check if callback was received
SELECT * FROM received_callbacks
WHERE session_id = 'YOUR_SESSION_ID';
```

**Possible Causes & Solutions:**

| Cause | How to Identify | Solution |
|-------|-----------------|----------|
| GIP didn't send callback | No received_callbacks entry | Manually send callback or check GIP logs |
| Callback received but not matched | received_callbacks exists but processed=false | Check session_id/trackingNumber match |
| Callback timed out | expected_callbacks.status = 'TIMEOUT' | Reset status and retry or trigger TSQ |
| Wrong callback URL sent to GIP | Check orchestrator logs | Verify ORCHESTRATOR_BASE_URL in .env |

**Manual Callback:**
```bash
curl -X POST "http://localhost:3002/api/v1/callbacks/receive/{instanceId}/{stepExecutionId}" \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "YOUR_SESSION_ID",
    "trackingNumber": "YOUR_TRACKING_NUMBER",
    "actionCode": "000",
    "approvalCode": "123456",
    "functionCode": "241"
  }'
```

**Reset Timed Out Callback:**
```sql
-- Reset expected callback status
UPDATE expected_callbacks
SET status = 'PENDING', expected_by = NOW() + INTERVAL '5 minutes'
WHERE id = 'CALLBACK_ID';

-- Reset flow instance status
UPDATE flow_instances
SET status = 'WAITING_CALLBACK'
WHERE id = 'YOUR_INSTANCE_ID';
```

---

### Scenario 3: Flow Completed Prematurely

**Symptoms:**
- Flow status is `COMPLETED` but not all steps executed
- Only 7 steps executed instead of 13
- No error message

**Diagnosis:**
```sql
-- Count step executions
SELECT COUNT(*) FROM step_executions
WHERE flow_instance_id = 'YOUR_INSTANCE_ID';

-- Check last executed step
SELECT fs.step_code, se.status, se.error_message
FROM step_executions se
JOIN flow_steps fs ON se.step_id = fs.id
WHERE se.flow_instance_id = 'YOUR_INSTANCE_ID'
ORDER BY se.started_at DESC
LIMIT 1;
```

**Possible Causes & Solutions:**

| Cause | How to Identify | Solution |
|-------|-----------------|----------|
| No step transitions defined | `flow_step_transitions` table empty or missing | Add transitions or use step_order fallback |
| `getNextStep` returns null | Check flowService.js logs | Fix transition logic |
| CONDITION step failed silently | Check condition evaluation | Verify actionCode values in config |

**Check Flow Steps Order:**
```sql
SELECT step_code, step_order, step_type, config
FROM flow_steps
WHERE flow_id = 'YOUR_FLOW_ID'
ORDER BY step_order;
```

---

### Scenario 4: Flow Failed with Error

**Symptoms:**
- Flow status is `FAILED`
- `last_error` field has error message

**Diagnosis:**
```sql
-- Get error details
SELECT
    fi.status,
    fi.last_error,
    fs.step_code as failed_step
FROM flow_instances fi
LEFT JOIN flow_steps fs ON fi.current_step_id = fs.id
WHERE fi.id = 'YOUR_INSTANCE_ID';

-- Get step execution error
SELECT
    fs.step_code,
    se.status,
    se.error_message,
    se.error_details
FROM step_executions se
JOIN flow_steps fs ON se.step_id = fs.id
WHERE se.flow_instance_id = 'YOUR_INSTANCE_ID'
AND se.status = 'FAILED';
```

---

## Callback Issues

### Scenario 5: Callback Not Matching

**Symptoms:**
- Callback received but flow doesn't continue
- `received_callbacks.processed = false`
- `expected_callbacks.status = 'PENDING'`

**Diagnosis:**
```sql
-- Compare expected vs received
SELECT
    'EXPECTED' as type,
    ec.session_id,
    ec.tracking_number,
    ec.status
FROM expected_callbacks ec
WHERE ec.flow_instance_id = 'YOUR_INSTANCE_ID'
UNION ALL
SELECT
    'RECEIVED' as type,
    rc.session_id,
    rc.tracking_number,
    CASE WHEN rc.processed THEN 'PROCESSED' ELSE 'UNPROCESSED' END
FROM received_callbacks rc
WHERE rc.session_id = 'YOUR_SESSION_ID';
```

**Possible Causes:**

| Cause | Solution |
|-------|----------|
| Session ID mismatch | Ensure GIP returns same sessionId |
| Tracking number mismatch | Ensure GIP returns same trackingNumber |
| Callback received before expected was created | Retry matching job will handle |
| Expected callback already matched | Check if duplicate callback |

---

### Scenario 6: Too Many Callbacks (Spam)

**Symptoms:**
- BFS receives hundreds of callbacks
- Same callback sent repeatedly
- Logs show repeated "Sending callback to BFS"

**Diagnosis:**
```sql
-- Check callback_sent flag
SELECT
    id,
    session_id,
    status,
    callback_sent,
    callback_sent_at
FROM flow_instances
WHERE callback_sent = false
AND status IN ('COMPLETED', 'FAILED');
```

**Causes & Solutions:**

| Cause | Solution |
|-------|----------|
| `callback_sent` never set to true | Fix code to set `callback_sent = true` after sending |
| Wrong column name in code | Ensure code uses `callback_sent` not `bfs_callback_sent` |
| Sync flows not marked | Set `callback_sent = true` for sync flows |

**Stop the spam:**
```sql
-- Mark all completed flows as callback sent
UPDATE flow_instances
SET callback_sent = true
WHERE status IN ('COMPLETED', 'FAILED')
AND callback_sent = false;
```

---

### Scenario 7: Callback Timeout

**Symptoms:**
- `expected_callbacks.status = 'TIMEOUT'`
- Flow stuck or failed

**Diagnosis:**
```sql
SELECT
    ec.id,
    ec.status,
    ec.expected_by,
    ec.created_at,
    EXTRACT(EPOCH FROM (ec.expected_by - ec.created_at)) as timeout_seconds
FROM expected_callbacks ec
WHERE ec.status = 'TIMEOUT'
AND ec.flow_instance_id = 'YOUR_INSTANCE_ID';
```

**Solutions:**

1. **Increase timeout:**
```sql
-- Increase callback timeout in step config
UPDATE flow_steps
SET config = jsonb_set(config, '{callbackTimeout}', '600000')  -- 10 minutes
WHERE step_code = 'FT_FTD_CALL';
```

2. **Manually resume after timeout:**
```sql
-- Reset to pending
UPDATE expected_callbacks
SET status = 'PENDING', expected_by = NOW() + INTERVAL '10 minutes'
WHERE id = 'CALLBACK_ID';

UPDATE flow_instances
SET status = 'WAITING_CALLBACK'
WHERE id = 'YOUR_INSTANCE_ID';
```

3. **Trigger TSQ (Transaction Status Query):**
```sql
-- Mark for TSQ
UPDATE flow_instances
SET current_payload = jsonb_set(current_payload::jsonb, '{needsTsq}', 'true')
WHERE id = 'YOUR_INSTANCE_ID';
```

---

## Database Column Errors

### Scenario 8: "Column X does not exist"

**Common Errors:**

| Error | Code Location | Fix |
|-------|---------------|-----|
| `column "is_matched" does not exist` | callbackService.js | Use `status` for expected_callbacks, `processed` for received_callbacks |
| `column "bfs_callback_sent" does not exist` | callbackMatcherJob.js | Use `callback_sent` |
| `column "event_type" does not exist` | processLogsModel | Use `log_type` |
| `column "job_data" does not exist` | flowExecutorJob.js | Use `payload` |
| `column "match_status" does not exist` | callbackService.js | Remove - doesn't exist in received_callbacks |

**Diagnosis - Check actual columns:**
```sql
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'YOUR_TABLE_NAME'
ORDER BY ordinal_position;
```

**Key Table Column Mappings:**

**expected_callbacks:**
```
id, flow_instance_id, step_execution_id, session_id, tracking_number,
callback_type, status, match_fields, success_conditions, failure_conditions,
expected_by, received_at, received_payload, match_result, metadata,
created_at, updated_at
```

**received_callbacks:**
```
id, session_id, tracking_number, source, callback_type, payload, headers,
action_code, approval_code, function_code, processed, matched_to_instance_id,
matched_to_step_id, processed_at, error_message, metadata, created_at, updated_at
```

**flow_instances:**
```
id, flow_id, session_id, tracking_number, status, current_step_id,
current_payload, final_response, bfs_callback_url, callback_sent,
callback_sent_at, error_count, last_error, started_at, completed_at,
metadata, created_at, updated_at
```

**job_queue:**
```
id, job_type, payload, status, priority, attempts, max_attempts,
error_message, started_at, completed_at, created_at, updated_at
```

---

## Step Execution Issues

### Scenario 9: API_CALL Step Fails with "External API configuration not found"

**Symptoms:**
- Step fails immediately
- Error: "External API configuration not found for step: STEP_ID"

**Diagnosis:**
```sql
-- Check step config
SELECT step_code, config FROM flow_steps
WHERE id = 'STEP_ID';

-- Check if apiId exists in external_apis
SELECT * FROM external_apis
WHERE id = 'API_ID_FROM_CONFIG';
```

**Causes & Solutions:**

| Cause | Solution |
|-------|----------|
| Missing `apiId` in config | Add apiId to step config |
| Wrong `apiId` value | Update with correct external_apis.id |
| API not in external_apis table | Insert API configuration |

**Fix:**
```sql
-- Add API config to step
UPDATE flow_steps
SET config = jsonb_set(config, '{apiId}', '"4c7be651-9733-4a14-89a1-2d1a4c4dbd09"')
WHERE step_code = 'YOUR_STEP';
```

---

### Scenario 10: TRANSFORM Step Not Applying Mappings

**Symptoms:**
- Transform step completes but payload unchanged
- Field values not transformed

**Diagnosis:**
```sql
-- Check step input_mapping
SELECT step_code, input_mapping FROM flow_steps
WHERE step_code LIKE '%TRANSFORM%'
AND flow_id = 'YOUR_FLOW_ID';

-- Check field_mappings table
SELECT * FROM field_mappings
WHERE mapping_code = 'YOUR_MAPPING_CODE';
```

**Causes & Solutions:**

| Cause | Solution |
|-------|----------|
| `input_mapping` is null/empty | Populate input_mapping JSON |
| Wrong mapping structure | Use `{ input: [...], output: [...] }` or array format |
| Field names don't match | Verify source/target field names |

**Correct Mapping Format:**
```json
[
  { "source": "srcBankCode", "target": "destBank" },
  { "source": "destBankCode", "target": "originBank" },
  { "source": null, "target": "functionCode", "default_value": "241" },
  { "source": null, "target": "amount", "transform": "formatAmount" }
]
```

---

### Scenario 11: CONDITION Step Always Fails/Passes

**Symptoms:**
- CONDITION step doesn't branch correctly
- Always goes to success or always to failure

**Diagnosis:**
```sql
-- Check condition config
SELECT step_code, config FROM flow_steps
WHERE step_type = 'CONDITION'
AND flow_id = 'YOUR_FLOW_ID';

-- Check actual actionCode in payload
SELECT current_payload FROM flow_instances
WHERE id = 'YOUR_INSTANCE_ID';
```

**Condition Config Structure:**
```json
{
  "condition_field": "actionCode",
  "success_values": ["000"],
  "failure_values": ["999", "381", "382", "383"]
}
```

**Causes & Solutions:**

| Cause | Solution |
|-------|----------|
| `condition_field` wrong | Set correct field name (e.g., `actionCode`) |
| `success_values` missing actual value | Add the success actionCode to array |
| Value not in either array | Add to appropriate array or handle unknown |
| Field value is string vs number | Ensure types match |

---

## API Call Failures

### Scenario 12: GIP Returns Error

**Common GIP Action Codes:**

| Code | Meaning | Action |
|------|---------|--------|
| `000` | Success | Continue flow |
| `001` | Processing | Wait for callback |
| `381` | Account not found | Fail flow |
| `909` | Timeout | Trigger TSQ |
| `912` | System unavailable | Retry or fail |
| `999` | Validation error | Fail flow |

**Diagnosis:**
```sql
-- Check API response
SELECT
    fs.step_code,
    se.api_response,
    se.api_status_code,
    se.error_message
FROM step_executions se
JOIN flow_steps fs ON se.step_id = fs.id
WHERE se.flow_instance_id = 'YOUR_INSTANCE_ID'
AND fs.step_type = 'API_CALL';
```

---

### Scenario 13: Connection Refused / Timeout

**Symptoms:**
- Error: "ECONNREFUSED" or "timeout"
- GIP not responding

**Diagnosis:**
```bash
# Test GIP connectivity
curl -X GET http://localhost:4001/health

# Check if GIP is running
netstat -an | grep 4001
```

**Solutions:**
1. Start GIP simulator: `cd ../gip-simulator && npm run dev`
2. Check GIP_BASE_URL in .env
3. Check firewall/network settings

---

## Transform Issues

### Scenario 14: Amount Not Preserved

**Symptoms:**
- Amount becomes `000000000000` after NEC
- FTD/FTC sent with zero amount

**Diagnosis:**
```sql
-- Check payload at each step
SELECT
    fs.step_code,
    se.input_payload->>'amount' as input_amount,
    se.output_payload->>'amount' as output_amount
FROM step_executions se
JOIN flow_steps fs ON se.step_id = fs.id
WHERE se.flow_instance_id = 'YOUR_INSTANCE_ID'
ORDER BY se.started_at;
```

**Solution:**
Store original amount before NEC and restore for FTD:
```json
// In FT_START or before NEC
{ "originalAmount": "payload.amount" }

// In FTD_TRANSFORM
{ "source": "originalAmount", "target": "amount" }
```

---

### Scenario 15: Field Mapping Swap Issues

**For FTD (Debit - Function Code 241):**
```
Client Field      → GIP Field
srcBankCode       → originBank
destBankCode      → destBank
srcAccountNumber  → accountToCredit
destAccountNumber → accountToDebit
srcAccountName    → nameToCredit
destAccountName   → nameToDebit
```

**For FTC (Credit - Function Code 240):**
```
Client Field      → GIP Field
srcBankCode       → destBank
destBankCode      → originBank
srcAccountNumber  → accountToCredit
destAccountNumber → accountToDebit
srcAccountName    → nameToCredit
destAccountName   → nameToDebit
```

---

## Job Queue Issues

### Scenario 16: Jobs Not Processing

**Diagnosis:**
```sql
-- Check pending jobs
SELECT * FROM job_queue
WHERE status = 'PENDING'
ORDER BY created_at;

-- Check failed jobs
SELECT id, job_type, error_message, attempts
FROM job_queue
WHERE status = 'FAILED'
ORDER BY created_at DESC
LIMIT 10;
```

**Solutions:**

1. **Restart background jobs:**
```bash
# Restart orchestrator
npm run dev
```

2. **Manually retry failed job:**
```sql
UPDATE job_queue
SET status = 'PENDING', attempts = 0, error_message = NULL
WHERE id = 'JOB_ID';
```

3. **Check job intervals in .env:**
```
JOB_FLOW_EXECUTOR_INTERVAL=5000
JOB_CALLBACK_MATCHER_INTERVAL=10000
```

---

## Common Error Messages

| Error | Location | Cause | Solution |
|-------|----------|-------|----------|
| "Flow instance not found" | executionService | Invalid instanceId | Check instanceId exists |
| "Step execution not found" | executionService | Invalid stepExecutionId | Check step_executions table |
| "External API configuration not found" | executionService | Missing apiId in step config | Add apiId to config |
| "Flow has no START step" | executionService | Missing START step | Add START step to flow |
| "Step not found in graph" | flowService | Step ID not in flow | Check flow_steps table |
| "Request failed with status code 404" | axios | Wrong endpoint URL | Check pathTemplate and base_url |
| "Request failed with status code 500" | axios | GIP internal error | Check GIP logs |
| "ECONNREFUSED" | axios | Service not running | Start the target service |
| "timeout" | axios | Service slow/unresponsive | Increase timeout or check service |

---

## Debugging Scripts

### Node.js Debug Script Template
```javascript
// Save as debug.js in orchestrator folder
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD
});

const instanceId = 'YOUR_INSTANCE_ID';

(async () => {
  try {
    // 1. Flow Instance
    const instance = await pool.query(`
      SELECT fi.*, fs.step_code, fs.step_type
      FROM flow_instances fi
      LEFT JOIN flow_steps fs ON fi.current_step_id = fs.id
      WHERE fi.id = $1
    `, [instanceId]);
    console.log('=== FLOW INSTANCE ===');
    console.log(JSON.stringify(instance.rows[0], null, 2));

    // 2. Step Executions
    const steps = await pool.query(`
      SELECT fs.step_code, se.status, se.error_message,
             (se.api_response::json)->>'actionCode' as action_code
      FROM step_executions se
      JOIN flow_steps fs ON se.step_id = fs.id
      WHERE se.flow_instance_id = $1
      ORDER BY se.started_at
    `, [instanceId]);
    console.log('\n=== STEP EXECUTIONS ===');
    steps.rows.forEach((s, i) => {
      console.log(`${i+1}. ${s.step_code} - ${s.status} ${s.action_code ? `(${s.action_code})` : ''} ${s.error_message || ''}`);
    });

    // 3. Expected Callbacks
    const callbacks = await pool.query(`
      SELECT * FROM expected_callbacks WHERE flow_instance_id = $1
    `, [instanceId]);
    console.log('\n=== EXPECTED CALLBACKS ===');
    console.log(JSON.stringify(callbacks.rows, null, 2));

    // 4. Current Payload
    if (instance.rows[0]?.current_payload) {
      console.log('\n=== CURRENT PAYLOAD ===');
      const payload = typeof instance.rows[0].current_payload === 'string'
        ? JSON.parse(instance.rows[0].current_payload)
        : instance.rows[0].current_payload;
      console.log(JSON.stringify(payload, null, 2));
    }

    await pool.end();
  } catch (err) {
    console.error('Error:', err.message);
    await pool.end();
  }
})();
```

**Run with:**
```bash
node debug.js
```

---

## Quick Reference - Flow Statuses

| Status | Meaning | Next Action |
|--------|---------|-------------|
| `PENDING` | Created, waiting for job | Wait for job executor |
| `RUNNING` | Currently executing | Wait for completion |
| `WAITING_CALLBACK` | Waiting for external callback | Send callback or wait |
| `COMPLETED` | Successfully finished | Check final_response |
| `FAILED` | Error occurred | Check last_error |
| `TIMEOUT` | Callback timed out | Trigger TSQ or retry |
| `MANUAL_INTERVENTION` | Needs human action | Review and resume |

---

## Quick Reference - Step Statuses

| Status | Meaning |
|--------|---------|
| `PENDING` | Not yet started |
| `RUNNING` | Currently executing |
| `COMPLETED` | Successfully finished |
| `FAILED` | Error occurred |
| `WAITING` | Waiting for callback |
| `TIMEOUT` | Callback timed out |
| `SKIPPED` | Condition not met |

---

## Monitoring Queries

### Active Flows Summary
```sql
SELECT
    status,
    COUNT(*) as count
FROM flow_instances
WHERE created_at > NOW() - INTERVAL '24 hours'
GROUP BY status;
```

### Callback Statistics
```sql
SELECT
    status,
    COUNT(*) as count,
    AVG(EXTRACT(EPOCH FROM (received_at - created_at))) as avg_wait_seconds
FROM expected_callbacks
WHERE created_at > NOW() - INTERVAL '24 hours'
GROUP BY status;
```

### Failed Steps Today
```sql
SELECT
    fs.step_code,
    COUNT(*) as failure_count,
    MAX(se.error_message) as last_error
FROM step_executions se
JOIN flow_steps fs ON se.step_id = fs.id
WHERE se.status = 'FAILED'
AND se.created_at > NOW() - INTERVAL '24 hours'
GROUP BY fs.step_code
ORDER BY failure_count DESC;
```

### Pending Jobs
```sql
SELECT
    job_type,
    COUNT(*) as pending_count,
    MIN(created_at) as oldest
FROM job_queue
WHERE status = 'PENDING'
GROUP BY job_type;
```
