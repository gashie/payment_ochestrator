# FT (Funds Transfer) Flow - Setup & Documentation

## Overview

FT (Funds Transfer) is an **asynchronous** flow that performs:
1. **NEC** - Verify source and destination accounts
2. **FTD** (Debit) - Debit the source account (function code `241`)
3. **FTC** (Credit) - Credit the destination account (function code `240`)
4. **Reversal** - If FTC fails after FTD succeeds

## Flow Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            FT (FUNDS TRANSFER) FLOW                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  START → NEC_SRC → NEC_DEST → FTD → [Callback] → CHECK                     │
│                                                       │                     │
│                              ┌────────────────────────┴──────────┐          │
│                              ▼                                   ▼          │
│                        [SUCCESS]                            [FAILED]        │
│                              │                                   │          │
│                              ▼                                   ▼          │
│                   FTC → [Callback] → CHECK                 FAIL_CALLBACK    │
│                                        │                         │          │
│                   ┌────────────────────┴─────────┐               ▼          │
│                   ▼                              ▼          END_FAIL        │
│             [SUCCESS]                       [FAILED]                        │
│                   │                              │                          │
│                   ▼                              ▼                          │
│           SUCCESS_CALLBACK                   REVERSAL                       │
│                   │                              │                          │
│                   ▼                              ▼                          │
│             END_SUCCESS                    END_REVERSAL                     │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Function Codes

| Operation | Function Code | Description |
|-----------|---------------|-------------|
| NEC | `230` | Name Enquiry Check |
| FTD | `241` | Funds Transfer Debit |
| FTC | `240` | Funds Transfer Credit |
| TSQ | `111` | Transaction Status Query |

## Field Mappings

### FTD (Debit) - Function Code 241

| Client Field | GIP Field |
|--------------|-----------|
| `srcBankCode` | `originBank` |
| `destBankCode` | `destBank` |
| `srcAccountNumber` | `accountToCredit` |
| `destAccountNumber` | `accountToDebit` |
| `srcAccountName` | `nameToCredit` |
| `destAccountName` | `nameToDebit` |

### FTC (Credit) - Function Code 240 (Swapped)

| Client Field | GIP Field |
|--------------|-----------|
| `srcBankCode` | `destBank` |
| `destBankCode` | `originBank` |
| `srcAccountNumber` | `accountToCredit` |
| `destAccountNumber` | `accountToDebit` |
| `srcAccountName` | `nameToCredit` |
| `destAccountName` | `nameToDebit` |

## Request Format

### Client Request to Orchestrator

```bash
POST http://localhost:3002/api/v1/process
Content-Type: application/json

{
  "eventType": "FT",
  "payload": {
    "sessionId": "260129200001",
    "trackingNumber": "FT001",
    "srcBankCode": "300307",
    "destBankCode": "300591",
    "srcAccountNumber": "0011010104334",
    "srcAccountName": "Fautina Abdulai",
    "destAccountNumber": "0246436671",
    "destAccountName": "Kwaku Manu",
    "amount": 10000,
    "channelCode": "100",
    "narration": "salary payment - nov23"
  },
  "metadata": {
    "callbackUrl": "http://localhost:3001/api/v1/callbacks/orchestrator",
    "applicationId": "550e8400-e29b-41d4-a716-446655440000",
    "bankId": "550e8400-e29b-41d4-a716-446655440001"
  }
}
```

### Response (Async - 202 Accepted)

```json
{
  "success": true,
  "data": {
    "flowInstanceId": "f1ecfc47-b746-469e-8201-11c1d7f02d34",
    "sessionId": "260129200001",
    "trackingNumber": "FT001",
    "status": "ACCEPTED",
    "message": "Request accepted for processing"
  }
}
```

## GIP Payloads

### FTD Request to GIP

```json
POST http://localhost:4001/api/v1/ftd

{
  "sessionId": "260129200001",
  "trackingNumber": "FT001",
  "originBank": "300307",
  "destBank": "300591",
  "accountToCredit": "0011010104334",
  "accountToDebit": "0246436671",
  "nameToCredit": "Fautina Abdulai",
  "nameToDebit": "Kwaku Manu",
  "amount": "000000001000",
  "functionCode": "241",
  "channelCode": "100",
  "narration": "salary payment - nov23",
  "dateTime": "260129164400",
  "callbackUrl": "http://localhost:3002/api/v1/callbacks/receive/{instanceId}/{stepId}"
}
```

### GIP Immediate Response

```json
{
  "sessionId": "260129200001",
  "trackingNumber": "FT001",
  "actionCode": "001",
  "approvalCode": "request being processed",
  "functionCode": "241"
}
```

### GIP FTD Callback (Success)

```json
POST http://localhost:3002/api/v1/callbacks/receive/{instanceId}/{stepId}

{
  "sessionId": "260129200001",
  "trackingNumber": "FT001",
  "actionCode": "000",
  "approvalCode": "633164",
  "functionCode": "241",
  "originBank": "300307",
  "destBank": "300591",
  "accountToCredit": "0011010104334",
  "accountToDebit": "0246436671",
  "nameToCredit": "Fautina Abdulai",
  "nameToDebit": "Kwaku Manu",
  "amount": "000000001000"
}
```

## Flow Steps (17 steps)

| # | Step Code | Type | Description |
|---|-----------|------|-------------|
| 1 | `FT_START` | START | Entry point |
| 2 | `FT_NEC_SRC_TRANSFORM` | TRANSFORM | Prepare NEC for source account |
| 3 | `FT_NEC_SRC_CALL` | API_CALL | Call GIP /nec for source |
| 4 | `FT_NEC_DEST_TRANSFORM` | TRANSFORM | Prepare NEC for dest account |
| 5 | `FT_NEC_DEST_CALL` | API_CALL | Call GIP /nec for dest |
| 6 | `FT_FTD_TRANSFORM` | TRANSFORM | Prepare FTD request |
| 7 | `FT_FTD_CALL` | API_CALL | Call GIP /ftd (waits for callback via includeCallback) |
| 8 | `FT_FTD_CHECK` | CONDITION | Check FTD result (actionCode: 000=success) |
| 9 | `FT_FTC_TRANSFORM` | TRANSFORM | Prepare FTC request |
| 10 | `FT_FTC_CALL` | API_CALL | Call GIP /ftc (waits for callback via includeCallback) |
| 11 | `FT_FTC_CHECK` | CONDITION | Check FTC result (actionCode: 000=success) |
| 12 | `FT_SUCCESS_CALLBACK` | API_CALL | Send success to BFS |
| 13 | `FT_END_SUCCESS` | END | Flow complete (success) |
| 14 | `FT_FTD_FAIL_CALLBACK` | API_CALL | Send FTD failure to BFS |
| 15 | `FT_END_FTD_FAIL` | END | Flow complete (FTD failed) |
| 16 | `FT_REVERSAL` | TASK | Trigger reversal |
| 17 | `FT_END_REVERSAL` | END | Flow complete (reversal) |

**Note:** The API_CALL steps (FT_FTD_CALL, FT_FTC_CALL) use `includeCallback: true` which automatically:
1. Adds the callback URL to the request sent to GIP
2. Registers an expected callback
3. Waits for the callback before continuing

## Callback Handling

### Callback Endpoints

| Endpoint | Purpose |
|----------|---------|
| `POST /api/v1/callbacks` | General callback |
| `POST /api/v1/callbacks/ftd` | FTD specific callback |
| `POST /api/v1/callbacks/ftc` | FTC specific callback |
| `POST /api/v1/callbacks/receive/:instanceId/:stepId` | Direct callback for instance |

### Callback Timeout

- Default timeout: **5 minutes** (300000ms)
- On timeout: Triggers TSQ (Transaction Status Query)

## Response Codes

| Action Code | Meaning | Next Action |
|-------------|---------|-------------|
| `000` | Success | Continue to next step |
| `001` | Processing | Wait for callback |
| `381` | Account not found | Fail |
| `909` | Timeout | Trigger TSQ |
| `912` | System unavailable | Trigger TSQ |
| `999` | Validation error | Fail |

## TSQ (Transaction Status Query)

If callback times out, TSQ is triggered with function code `111`:

```json
{
  "sessionId": "260129200001",
  "trackingNumber": "FT001",
  "originBank": "300307",
  "destBank": "300591",
  "functionCode": "111",
  "amount": "000000001000",
  "channelCode": "100"
}
```

## Reversal

If FTC fails after FTD succeeded:
1. Reversal is triggered to credit back the debited account
2. Uses FTD format with swapped accounts
3. Also requires callback handling and TSQ

## Testing

### 1. Start Services

```bash
# Start GIP simulator (port 4001)
cd ../gip-simulator && npm run dev

# Start Orchestrator (port 3002)
npm run dev
```

### 2. Send FT Request

```bash
curl -X POST "http://localhost:3002/api/v1/process" \
  -H "Content-Type: application/json" \
  -d '{
    "eventType": "FT",
    "payload": {
      "sessionId": "260129200001",
      "trackingNumber": "FT001",
      "srcBankCode": "300307",
      "destBankCode": "300591",
      "srcAccountNumber": "0011010104334",
      "srcAccountName": "Fautina Abdulai",
      "destAccountNumber": "0246436671",
      "destAccountName": "Kwaku Manu",
      "amount": 10000,
      "channelCode": "100",
      "narration": "salary payment"
    },
    "metadata": {
      "callbackUrl": "http://localhost:3001/api/v1/callbacks/orchestrator",
      "applicationId": "550e8400-e29b-41d4-a716-446655440000",
      "bankId": "550e8400-e29b-41d4-a716-446655440001"
    }
  }'
```

### 3. Check Flow Status

```sql
SELECT status, current_step_id, last_error
FROM flow_instances
WHERE session_id = '260129200001';
```

### 4. Manually Send Callback (if GIP simulator doesn't auto-send)

```bash
# Get the instanceId and stepId from expected_callbacks table
curl -X POST "http://localhost:3002/api/v1/callbacks/receive/{instanceId}/{stepId}" \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "260129200001",
    "trackingNumber": "FT001",
    "actionCode": "000",
    "approvalCode": "123456",
    "functionCode": "241"
  }'
```

## Troubleshooting

For comprehensive troubleshooting, see [TROUBLESHOOTING.md](./TROUBLESHOOTING.md).

### Quick Debug Queries

```sql
-- Check flow status
SELECT fi.status, fi.last_error, fs.step_code
FROM flow_instances fi
LEFT JOIN flow_steps fs ON fi.current_step_id = fs.id
WHERE fi.session_id = 'YOUR_SESSION_ID';

-- Check step executions
SELECT fs.step_code, se.status,
       (se.api_response::json)->>'actionCode' as action_code
FROM step_executions se
JOIN flow_steps fs ON se.step_id = fs.id
WHERE se.flow_instance_id = 'YOUR_INSTANCE_ID'
ORDER BY se.started_at;

-- Check expected callbacks
SELECT id, status, expected_by
FROM expected_callbacks
WHERE flow_instance_id = 'YOUR_INSTANCE_ID';
```

### Flow stuck in PENDING
- Check `job_queue` table for errors
- Verify background jobs are running
- Manually create job: `INSERT INTO job_queue (job_type, payload, status, priority) VALUES ('EXECUTE_FLOW', '{"flowInstanceId": "ID"}', 'PENDING', 1);`

### Flow stuck in WAITING_CALLBACK
- Check `expected_callbacks.status` - should be `PENDING`
- Verify callback URL sent to GIP: `http://localhost:3002/api/v1/callbacks/receive/{instanceId}/{stepId}`
- Check GIP simulator logs for callback sending
- Manually send callback if needed (see example above)

### Callback timed out
- Expected callback shows `status = 'TIMEOUT'`
- Reset: `UPDATE expected_callbacks SET status = 'PENDING', expected_by = NOW() + INTERVAL '5 min' WHERE id = 'ID'`

### Callback not matched
- Verify `sessionId` and `trackingNumber` match exactly
- Check both `received_callbacks` and `expected_callbacks` tables
- Session ID is case-sensitive

### CONDITION step fails (FT_FTD_CHECK, FT_FTC_CHECK)
- Check the step config for correct `condition_field`, `success_values`, `failure_values`
- Verify `actionCode` in payload matches expected values
- Config format:
```json
{
  "condition_field": "actionCode",
  "success_values": ["000"],
  "failure_values": ["999", "381", "382", "383"]
}
```

### Amount shows as zero
- NEC transforms set amount to `000000000000` (correct for NEC)
- **FT_NEC_SRC_TRANSFORM** now preserves original amount in `originalAmount` field
- **FT_FTD_TRANSFORM** and **FT_FTC_TRANSFORM** read from `originalAmount` to get correct amount
- If amount is still zero, check `originalAmount` is being preserved in payload

## Condition Check Configuration

| Step | Condition Field | Success Values | Failure Values |
|------|-----------------|----------------|----------------|
| FT_FTD_CHECK | actionCode | ["000"] | ["999", "381", "382", "383"] |
| FT_FTC_CHECK | actionCode | ["000"] | ["999", "381", "382", "383"] |

## Files Modified

| File | Change |
|------|--------|
| `src/controllers/processController.js` | Fixed `job_data` → `payload` column |
| `src/jobs/flowExecutorJob.js` | Fixed `job.job_data` → `job.payload` |
| `src/controllers/callbacksController.js` | Added `receiveCallbackForStep` |
| `src/routes/index.js` | Added callback receive route |
| `src/services/callbackService.js` | Fixed column names (`status`, `processed`, `log_type`) |
| `src/services/flowService.js` | Added step_order fallback for getNextStep |
| `src/services/tsqService.js` | Fixed column names (`original_session_id`, `attempt_number`, etc.) |
| `src/jobs/tsqSchedulerJob.js` | Fixed payload passing to createTsqRequest |
| `src/jobs/callbackMatcherJob.js` | Fixed `status = 'PENDING'` instead of `WAITING` |
| `.env` | Added `ORCHESTRATOR_BASE_URL` |
| `tools/troubleshooter/` | Added terminal-style troubleshooting app |

## Database Updates

| Table | Change |
|-------|--------|
| `flow_steps.FT_NEC_SRC_TRANSFORM` | Added `originalAmount` preservation |
| `flow_steps.FT_FTD_TRANSFORM` | Now reads from `originalAmount` |
| `flow_steps.FT_FTC_TRANSFORM` | Now reads from `originalAmount` |
| `flow_steps.FT_SUCCESS_CALLBACK` | Added BFS API config |
