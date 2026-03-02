#!/usr/bin/env python3
"""
Import all Vapi calls into NocoDB call_logs table.
Test calls (no empresa) are marked with ended_reason='Manual Trigger'.
Campaign calls keep their original ended_reason.
"""

import json
import urllib.request
from datetime import datetime

VAPI_API_KEY = "852080ba-ce7c-4778-b218-bf718613a2b6"
NOCODB_BASE = "https://nocodb.srv889387.hstgr.cloud/api/v2/tables"
CALL_LOGS_TABLE = "m013en5u2cyu30j"
XC_TOKEN = "jx3uoKeVaidZLF7M0skVb9pV6yvNsam0Hu-Vfeww"

def fetch_vapi_calls():
    req = urllib.request.Request(
        "https://api.vapi.ai/call?limit=100",
        headers={"Authorization": f"Bearer {VAPI_API_KEY}"}
    )
    resp = urllib.request.urlopen(req)
    return json.loads(resp.read())

def calc_duration(call):
    if call.get('startedAt') and call.get('endedAt'):
        s = datetime.fromisoformat(call['startedAt'].replace('Z', '+00:00'))
        e = datetime.fromisoformat(call['endedAt'].replace('Z', '+00:00'))
        return int((e - s).total_seconds())
    return 0

def evaluate_call(ended, duration):
    if ended == 'voicemail':
        return 'Contestador'
    if ended == 'silence-timed-out':
        return 'No contesta'
    if ended == 'customer-busy':
        return 'No contesta'
    if ended and 'error' in ended:
        return 'Error'
    if duration and duration < 10:
        return 'No contesta'
    if ended == 'customer-ended-call' and duration and duration > 30:
        return 'Completada'
    if ended == 'assistant-ended-call' and duration and duration > 20:
        return 'Completada'
    return 'Sin datos'

def import_to_nocodb(records):
    batch_size = 10
    success = 0
    for i in range(0, len(records), batch_size):
        batch = records[i:i+batch_size]
        url = f"{NOCODB_BASE}/{CALL_LOGS_TABLE}/records"
        payload = json.dumps(batch).encode('utf-8')
        
        req = urllib.request.Request(url, data=payload, method='POST')
        req.add_header('xc-token', XC_TOKEN)
        req.add_header('Content-Type', 'application/json')
        
        try:
            resp = urllib.request.urlopen(req)
            result = json.loads(resp.read())
            created_count = len(result) if isinstance(result, list) else 1
            success += created_count
            print(f"  Batch {i//batch_size + 1}: imported {created_count} records")
        except Exception as e:
            error_body = ''
            if hasattr(e, 'read'):
                error_body = e.read().decode('utf-8', errors='replace')
            print(f"  Batch {i//batch_size + 1}: ERROR - {e}")
            print(f"    Body: {error_body[:500]}")
    
    return success

def main():
    print("📡 Fetching calls from Vapi API...")
    calls = fetch_vapi_calls()
    print(f"   Found {len(calls)} calls in Vapi\n")
    
    records = []
    test_count = 0
    campaign_count = 0
    
    for c in calls:
        empresa = c.get('assistantOverrides', {}).get('variableValues', {}).get('empresa', '')
        phone = c.get('customer', {}).get('number', '') or 'Desconocido'
        created = c.get('createdAt', '')
        ended = c.get('endedReason', '')
        call_id = c.get('id', '')
        transcript = c.get('artifact', {}).get('transcript', '') or ''
        recording = c.get('artifact', {}).get('recordingUrl', '') or ''
        
        is_test = not empresa
        duration = calc_duration(c)
        evaluation = evaluate_call(ended, duration)
        
        record = {
            'vapi_call_id': call_id,
            'lead_name': 'Test Manual' if is_test else empresa,
            'phone_called': phone,
            'call_time': created,
            'ended_reason': 'Manual Trigger' if is_test else ended,
            'evaluation': evaluation,
            'duration_seconds': duration,
        }
        if transcript:
            record['transcript'] = transcript[:5000]
        if recording:
            record['recording_url'] = recording
        
        records.append(record)
        if is_test:
            test_count += 1
        else:
            campaign_count += 1
    
    print(f"📊 Records prepared:")
    print(f"   🧪 Test (manual): {test_count}")
    print(f"   📞 Campaign: {campaign_count}")
    print(f"   📦 Total: {len(records)}\n")
    
    print("⬆️  Importing to NocoDB...")
    success = import_to_nocodb(records)
    print(f"\n✅ Import complete: {success}/{len(records)} records imported")

if __name__ == '__main__':
    main()
