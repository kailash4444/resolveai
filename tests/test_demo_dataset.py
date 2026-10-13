from collections import Counter
import csv
from datetime import datetime, timezone
import json
from zipfile import ZipFile

import pytest

from realapp.demo_dataset import (DATASET, GREETING, EXPECTED_COUNTS, import_dataset, export_dataset, plans)
from realapp.engine import parse_transcript as parse_openai
from realapp.gemini import parse_transcript as parse_gemini
from realapp.calling import Login
from realapp.access import can_read
from test_calling import service


def test_import_exact_counts_ownership_diarization_and_repeat_safety(service, tmp_path):
    logins = tmp_path/'private/logins.csv'
    result = import_dataset(service, service.case_store, credentials_path=logins,
        reference_time=datetime(2026,10,13,tzinfo=timezone.utc))
    assert (result['created_accounts'],result['created_calls'],result['created_incidents']) == (50,85,85)
    assert len(result['technicians'])==20 and len(result['customers'])==30
    assert Counter(p['group'] for p in plans()) == EXPECTED_COUNTS
    assert Counter(p['subtype'] for p in plans())['Printer/workstation connection']==6
    assert Counter(p['subtype'] for p in plans())['Out of toner']==3
    assert Counter(p['subtype'] for p in plans())['Blank printouts']==4
    techs={u['id']:u for u in result['technicians']}; customers={u['id']:u for u in result['customers']}
    assert {case.ticket.assigned_user_id for case in result['cases']} == set(techs)
    assert {case.customer_id for case in result['cases']} == set(customers)
    for case in result['cases']:
        call=service.get(case.ticket.call_id)
        assert call['case_id']==case.id and call['status']=='Completed'
        assert call['technician_id']==case.ticket.assigned_user_id
        assert call['customer_id']==case.customer_id
        assert case.demo_dataset==DATASET and len(case.transcript)==12
        assert case.transcript[0].speaker=='Technician' and case.transcript[0].text==GREETING
        assert case.transcript[1].speaker=='Customer'
        assert case.transcript[0].speaker_name==case.ticket.assigned_to
        assert case.transcript[1].speaker_name==case.caller
        assert all(t.speaker in {'Technician','Customer'} and t.speaker_name for t in case.transcript)
        assert not case.qa_checks and case.quality_score is None
        assert bool(case.ticket.resolution)==(case.ticket.state=='Resolved')
        assert can_read(case,customers[case.customer_id])
        assert not can_read(case,next(u for u in customers.values() if u['id']!=case.customer_id))
    edited=result['cases'][0];edited.ticket.description='A technician edited this record.';service.case_store.save_case(edited)
    before=logins.read_bytes()
    again=import_dataset(service,service.case_store,credentials_path=logins)
    assert (again['created_accounts'],again['created_calls'],again['created_incidents']) == (0,0,0)
    assert logins.read_bytes()==before
    assert service.case_store.get_case(edited.id).ticket.description=='A technician edited this record.'
    with logins.open(encoding='utf-8',newline='') as handle:
        credentials=list(csv.DictReader(handle))
    for role in ('customer','technician'):
        row=next(r for r in credentials if r['role']==role)
        _, user=service.login(Login(username=row['username'],password=row['password']),'test')
        assert user['role']==role and user['name']==row['name']
    export_dataset(result,tmp_path/'export')
    with ZipFile(tmp_path/'export/ResolveAI_Demo_Transcripts.zip') as archive:
        assert len([name for name in archive.namelist() if name.split('/')[-1].startswith('CALL-DEMO-')])==85
        roster=archive.read('ResolveAI_Demo_Transcripts/accounts.csv').decode()
        assert 'password' not in roster
        data=json.loads(archive.read('ResolveAI_Demo_Transcripts/incidents.json'))
        assert len(data)==85


@pytest.mark.parametrize('parse',[parse_openai,parse_gemini])
def test_named_speakers_keep_canonical_roles_on_paste(parse):
    turns=parse('[2026-10-13T10:00:00+00:00] Technician (Arjun Reddy): '+GREETING+'\nCustomer (Aarav Mehta): I cannot print.')
    assert [t.speaker for t in turns]==['Technician','Customer']
    assert [t.speaker_name for t in turns]==['Arjun Reddy','Aarav Mehta']
