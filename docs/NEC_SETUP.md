# NEC (Name Enquiry Check) - Setup & Flow Documentation

## Overview

NEC (Name Enquiry Check) is a **synchronous** flow that verifies if an account exists and retrieves the account holder's name. It's used before funds transfers to validate recipient accounts.

**Function Code:** `230`

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  CLIENT REQUEST (to Orchestrator :3002)                        │
├─────────────────────────────────────────────────────────────────┤
│  POST /api/v1/process?isSync=true                              │
│  {                                                              │
│    eventType: "NEC",                                            │
│    payload: { sessionId, trackingNumber, srcBankCode, ... }    │
│  }                                                              │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  ORCHESTRATOR (Flow Execution)                                  │
├─────────────────────────────────────────────────────────────────┤
│  START → TRANSFORM_REQ → API_CALL → TRANSFORM_RES → END        │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  GIP (Ghana Interbank Payment) :4001                           │
├─────────────────────────────────────────────────────────────────┤
│  POST /api/v1/nec                                               │
│  { functionCode: "230", originBank, destBank, ... }            │
└─────────────────────────────────────────────────────────────────┘
```

## Setup Requirements

### 1. Environment Variables (.env)

```env
PORT=3002
GIP_BASE_URL=http://localhost:4001/api/v1
DB_HOST=localhost
DB_PORT=5432
DB_NAME=orchestrator_db
DB_USER=postgres
DB_PASSWORD=your_password
```

### 2. Database Setup

```bash
# Run migrations
npm run migrate

# Seed the database (creates NEC flow, GIP API config, field mappings)
npm run seed
```

### 3. Start Services

```bash
# Start GIP simulator (port 4001)
cd ../gip-simulator && npm run dev

# Start Orchestrator (port 3002)
npm run dev
```

## Request Format

### Your Request to Orchestrator

```json
POST http://localhost:3002/api/v1/process?isSync=true
Content-Type: application/json

{
  "eventType": "NEC",
  "payload": {
    "sessionId": "260129160001",       // 12 chars max, unique per request
    "trackingNumber": "TRK001",        // 10 chars max
    "srcBankCode": "300300",           // Source bank code
    "destBankCode": "300315",          // Destination bank code
    "srcAccountNumber": "0246089019",  // Source account
    "destAccountNumber": "0246089019", // Account to verify
    "channelCode": "100",
    "narration": "Name Enquiry",
    "dateTime": "260129160000"         // YYMMDDHHMMSS format
  },
  "metadata": {
    "callbackUrl": "http://localhost:3001/callbacks",
    "applicationId": "550e8400-e29b-41d4-a716-446655440000",
    "bankId": "550e8400-e29b-41d4-a716-446655440001"
  }
}
```

### Transformed Request to GIP

The orchestrator transforms your request before sending to GIP:

| Your Field | GIP Field | Notes |
|------------|-----------|-------|
| `srcBankCode` | `destBank` | **Swapped** |
| `destBankCode` | `originBank` | **Swapped** |
| `srcAccountNumber` | `accountToCredit` | **Swapped** |
| `destAccountNumber` | `accountToDebit` | **Swapped** |
| - | `functionCode` | Injected as `"230"` |
| - | `amount` | Injected as `"000000000000"` |
| `narration` | `narration` | Passed through |
| `channelCode` | `channelCode` | Default `"100"` |
| - | `dateTime` | Formatted to YYMMDDHHMMSS |

**Example GIP Request:**

```json
{
  "sessionId": "260129160001",
  "trackingNumber": "TRK001",
  "originBank": "300315",
  "destBank": "300300",
  "accountToDebit": "0246089019",
  "accountToCredit": "0246089019",
  "functionCode": "230",
  "amount": "000000000000",
  "channelCode": "100",
  "narration": "Name Enquiry",
  "dateTime": "260129160512"
}
```

## Response Format

### Success Response

```json
{
  "success": true,
  "data": {
    "flowInstanceId": "5ea2f43b-60e8-4181-ad77-bf58480471c9",
    "status": "COMPLETED"
  }
}
```

### GIP Response (stored in flow instance)

```json
{
  "actionCode": "000",
  "approvalCode": "206901",
  "nameToCredit": "ENOCH DANSO CLINTON",
  "accountToCredit": "0246089019",
  "functionCode": "230"
}
```

## Response Codes

| Action Code | Meaning |
|-------------|---------|
| `000` | Success - Account found |
| `381` | Account not found |
| `909` | System timeout (triggers TSQ) |
| `912` | System unavailable |
| `999` | Validation error |

## Flow Steps

| # | Step Code | Type | Description |
|---|-----------|------|-------------|
| 1 | `NEC_START` | START | Entry point |
| 2 | `NEC_TRANSFORM_REQ` | TRANSFORM | Apply field mappings to prepare GIP request |
| 3 | `NEC_API_CALL` | API_CALL | POST to GIP `/nec` endpoint |
| 4 | `NEC_TRANSFORM_RES` | TRANSFORM | Format GIP response |
| 5 | `NEC_END` | END | Complete flow |

## Database Tables

### Key Tables for NEC

- `flows` - Flow definition (NEC_FLOW)
- `flow_steps` - Individual steps with config and input_mapping
- `external_apis` - GIP API configuration
- `field_mappings` - Transformation rules
- `flow_instances` - Running/completed instances
- `step_executions` - Execution log per step

### Query Flow Instance Result

```sql
SELECT current_payload FROM flow_instances
WHERE session_id = '260129160001';
```

## Test Accounts (GIP Simulator)

| Account | Name | Balance |
|---------|------|---------|
| 0246089019 | ENOCH DANSO CLINTON | 50,000 |
| 0246436671 | KWAKU MANU | 25,000 |
| 00110104334 | FAUTINA ABDULAI | 100,000 |
| 1020820171412 | OLAM PURCHASE ACCOUNT | 500,000 |
| 0011010104334 | FAUTINA ABDULAI | 75,000 |

## Troubleshooting

### Common Issues

1. **"External API configuration not found"**
   - Check `flow_steps.config` has `apiId` (not `api_id`)
   - Check `flow_steps.config` has `pathTemplate` (not `endpoint`)
   - Run `npm run seed` again after fixing

2. **"Duplicate session_id"**
   - Each request needs a unique `sessionId`
   - Max length: 12 characters

3. **Transform not applied**
   - Check `flow_steps.input_mapping` is populated
   - Ensure `field_mappings` table has the mapping

4. **Account not found (381)**
   - Verify account exists in GIP simulator
   - Check field mapping is swapping correctly

### Debug Query

```sql
-- Check step execution
SELECT fs.step_code, se.status, se.input_payload, se.output_payload
FROM step_executions se
JOIN flow_steps fs ON se.step_id = fs.id
WHERE se.flow_instance_id = 'your-instance-id'
ORDER BY se.started_at;
```

## Example Test Command

```bash
curl -X POST "http://localhost:3002/api/v1/process?isSync=true" \
  -H "Content-Type: application/json" \
  -d '{
    "eventType": "NEC",
    "payload": {
      "sessionId": "260129170001",
      "trackingNumber": "TRK001",
      "srcBankCode": "300300",
      "destBankCode": "300315",
      "srcAccountNumber": "0246089019",
      "destAccountNumber": "0246089019",
      "channelCode": "100",
      "narration": "Name Enquiry",
      "dateTime": "260129170000"
    },
    "metadata": {
      "callbackUrl": "http://localhost:3001/callbacks",
      "applicationId": "550e8400-e29b-41d4-a716-446655440000",
      "bankId": "550e8400-e29b-41d4-a716-446655440001"
    }
  }'
```

## Files Modified/Created

| File | Purpose |
|------|---------|
| `src/services/executionService.js` | Fixed transform step to handle `{ input, output }` mapping structure |
| `src/utils/helpers.js` | Fixed `applyFieldMappings` to support both `source`/`target` and `source_field`/`target_field` naming |
| `scripts/seed.js` | Updated to use correct config keys (`apiId`, `pathTemplate`) and populate `input_mapping` |
