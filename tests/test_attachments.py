from types import SimpleNamespace
import pytest
from fastapi.testclient import TestClient

from realapp import main
from realapp.calling_store import MemoryCallingStore
from realapp.store import MemoryStore
from realapp.gemini import GeminiEngine
from realapp.config import Settings


@pytest.fixture
def accounts(monkeypatch):
    store = MemoryStore()
    engine = GeminiEngine(Settings(llm_provider='mock'), store.list_knowledge)
    service = main.calling
    monkeypatch.setattr(service, 'repository', MemoryCallingStore())
    monkeypatch.setattr(service, 'case_store', store)
    monkeypatch.setattr(service, 'engine', engine)
    monkeypatch.setattr(main, 'store', store)
    monkeypatch.setattr(main, 'engine', engine)

    admin = TestClient(main.app)
    assert admin.post('/api/auth/setup', json={'name': 'Admin', 'username': 'admin', 'password': 'isolated-admin-password'}).status_code == 201
    result = SimpleNamespace(admin=admin, store=store, engine=engine, service=service)

    for name, role in [('tech_1', 'technician'), ('cust_1', 'customer'), ('cust_2', 'customer')]:
        value = {'name': name, 'username': name, 'password': 'isolated-user-password', 'role': role}
        created = admin.post('/api/users', json=value)
        assert created.status_code == 201, created.text
        client = TestClient(main.app)
        assert client.post('/api/auth/login', json={**value, 'expected_role': 'customer' if role == 'customer' else 'technician'}).status_code == 200
        setattr(result, name, client)
        setattr(result, f'{name}_id', created.json()['id'])
    return result


def test_customer_incident_creation_with_photo(accounts):
    photo_bytes = b'\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15c4'
    files = [('attachments', ('error_screenshot.png', photo_bytes, 'image/png'))]
    data = {
        'short_description': 'Application screen is completely blank',
        'description': 'When launching the reporting dashboard, the screen turns blank and freezes.',
        'service': 'Reporting Portal',
    }

    response = accounts.cust_1.post('/api/customer/incidents', data=data, files=files)
    assert response.status_code == 201, response.text
    case = response.json()

    assert case['issue_title'] == 'Application screen is completely blank'
    attachments = case['ticket']['attachments']
    assert len(attachments) == 1
    assert attachments[0]['filename'] == 'error_screenshot.png'
    assert attachments[0]['content_type'] == 'image/png'
    assert attachments[0]['size_bytes'] == len(photo_bytes)
    assert attachments[0]['url'].startswith('/api/attachments/')

    # Analysis runs in the background after the response; read the saved ticket.
    case = accounts.cust_1.get(f"/api/cases/{case['id']}").json()
    # Mock mode clearly says that attachment bytes were not analyzed, in one short audit note
    # (the findings themselves live in visual_analysis, not duplicated in the note).
    work_notes = case['ticket']['work_notes']
    vision_notes = [n for n in work_notes if n['author'] == 'Image analysis']
    assert len(vision_notes) == 1
    assert 'Image analysis unavailable' in vision_notes[0]['text']
    assert 'demo mode' in vision_notes[0]['text'] and 'suggestion only' in vision_notes[0]['text']
    assert "isn't configured" not in vision_notes[0]['text'] and ' A AI ' not in vision_notes[0]['text']
    assert case['ticket']['visual_analysis']['analysis_source'] == 'Demo mode (media not analyzed)'


def test_customer_incident_creation_rejects_video(accounts):
    video_bytes = b'\x00\x00\x00 ftypisom\x00\x00\x02\x00isomiso2mp41'
    files = [('attachments', ('screen_recording.mp4', video_bytes, 'video/mp4'))]
    data = {
        'short_description': 'VPN fails to connect',
        'description': 'The corporate VPN disconnects immediately and shows a gateway timeout error.',
        'service': 'Corporate VPN',
    }

    response = accounts.cust_1.post('/api/customer/incidents', data=data, files=files)
    assert response.status_code == 415, response.text
    assert 'Only image uploads' in response.json()['detail']


def test_customer_incident_with_multiple_media_files(accounts):
    photo_bytes1 = b'\x89PNG\r\n\x1a\nvalid-test-content'
    photo_bytes2 = b'\xff\xd8\xffvalid-test-jpeg-content'
    files = [
        ('attachments', ('capture1.png', photo_bytes1, 'image/png')),
        ('attachments', ('capture2.jpg', photo_bytes2, 'image/jpeg')),
    ]
    data = {
        'short_description': 'System crashed during export',
        'description': 'Exporting 500 records causes an unhandled application crash dialog.',
        'service': 'Database Export',
    }

    response = accounts.cust_1.post('/api/customer/incidents', data=data, files=files)
    assert response.status_code == 201, response.text
    case = response.json()
    assert len(case['ticket']['attachments']) == 2


def test_customer_incident_rejects_more_than_three_images(accounts):
    photo_bytes = b'\x89PNG\r\n\x1a\nvalid-test-content'
    files = [
        ('attachments', (f'capture_{i}.png', photo_bytes, 'image/png'))
        for i in range(4)
    ]
    data = {
        'short_description': 'Too many images attached',
        'description': 'Customer attached four images.',
        'service': 'General',
    }
    response = accounts.cust_1.post('/api/customer/incidents', data=data, files=files)
    assert response.status_code == 400
    assert 'Maximum number of files is 3' in response.json()['detail'] or 'up to 3' in response.json()['detail']


def test_image_information_extraction_engine():
    from realapp.gemini import GeminiEngine
    from realapp.models import Attachment
    engine = GeminiEngine(Settings(gemini_provider='google_ai'), lambda: [])
    png_bytes = b'\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15c4'
    att = Attachment(id='ATT-1', filename='database_crash_502.png', content_type='image/png', size_bytes=len(png_bytes), url='/api/attachments/ATT-1')
    res = engine.analyze_visual('Database connection timed out with 502 Bad Gateway', [(att, png_bytes)])
    assert 'Local Extraction' in res.analysis_source
    assert 'database_crash_502.png' in res.visual_observations
    assert 'Database' in res.suggested_service or 'Gateway' in res.suggested_service
    assert res.technical_diagnosis != ''
    assert res.recommended_action != ''


def test_customer_incident_visual_analysis_attached(accounts, monkeypatch):
    from realapp.gemini import GeminiEngine
    live_engine = GeminiEngine(Settings(gemini_provider='google_ai'), accounts.store.list_knowledge)
    monkeypatch.setattr(main, 'engine', live_engine)
    monkeypatch.setattr(accounts.service, 'engine', live_engine)

    png_bytes = b'\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x01\x00\x00\x00\x01\x00\x08\x06\x00\x00\x00\x1f\x15c4crash_exception_freeze'
    files = [('attachments', ('crash_dialog.png', png_bytes, 'image/png'))]
    data = {
        'short_description': 'Application freeze and crash',
        'description': 'The application crashed suddenly during data load.',
        'service': 'General',
    }
    resp = accounts.cust_1.post('/api/customer/incidents', data=data, files=files)
    assert resp.status_code == 201
    case = accounts.cust_1.get(f"/api/cases/{resp.json()['id']}").json()
    va = case['ticket']['visual_analysis']
    assert va is not None
    assert 'crash_dialog.png' in va['visual_observations']
    assert va['technical_diagnosis'] != ''
    assert va['suggested_priority'] in ['P1', 'P2', 'P3']
    assert va['recommended_action'] != ''
    # A rule-based estimate is kept as a suggestion only; it must not overwrite ticket fields.
    assert 'Local Extraction' in va['analysis_source']
    assert case['ticket']['priority'] == 'P3' and case['ticket']['category'] == 'Incident'


def test_attachment_access_control(accounts):
    photo_bytes = b'\xff\xd8\xfftest-secret-image-content'
    files = [('attachments', ('evidence.jpg', photo_bytes, 'image/jpeg'))]
    data = {
        'short_description': 'Login issue',
        'description': 'Unable to log into the corporate payroll portal.',
        'service': 'Payroll',
    }

    create_resp = accounts.cust_1.post('/api/customer/incidents', data=data, files=files)
    assert create_resp.status_code == 201
    att_id = create_resp.json()['ticket']['attachments'][0]['id']

    # 1. Owner customer can view/download
    owner_get = accounts.cust_1.get(f'/api/attachments/{att_id}')
    assert owner_get.status_code == 200
    assert owner_get.content == photo_bytes
    assert owner_get.headers['content-type'] == 'image/jpeg'

    # 2. Technician can view/download
    tech_get = accounts.tech_1.get(f'/api/attachments/{att_id}')
    assert tech_get.status_code == 200
    assert tech_get.content == photo_bytes

    # 3. Another customer CANNOT view/download (returns 404 to avoid enumeration)
    other_cust_get = accounts.cust_2.get(f'/api/attachments/{att_id}')
    assert other_cust_get.status_code == 404

    # 4. Anonymous/unauthenticated gets 401
    anon_client = TestClient(main.app)
    assert anon_client.get(f'/api/attachments/{att_id}').status_code == 401


def test_reject_unsupported_file_types(accounts):
    files = [('attachments', ('script.sh', b'#!/bin/sh\necho hack', 'text/x-sh'))]
    data = {
        'short_description': 'Some issue',
        'description': 'Here is a shell script describing what happened.',
        'service': 'General',
    }
    response = accounts.cust_1.post('/api/customer/incidents', data=data, files=files)
    assert response.status_code == 415
    assert 'not supported' in response.json()['detail']


def test_reject_empty_attachment(accounts):
    files = [('attachments', ('empty.png', b'', 'image/png'))]
    data = {
        'short_description': 'Some issue',
        'description': 'Screenshot file was accidentally empty.',
        'service': 'General',
    }
    response = accounts.cust_1.post('/api/customer/incidents', data=data, files=files)
    assert response.status_code == 400
    assert 'empty' in response.json()['detail']


def test_add_attachments_to_existing_case(accounts):
    # Create incident without files
    res = accounts.cust_1.post('/api/customer/incidents', json={
        'short_description': 'Email not working',
        'description': 'Cannot send emails from Gmail account.',
        'service': 'Google Workspace'
    })
    assert res.status_code == 201
    case_id = res.json()['id']

    # Add photo attachment
    files = [('attachments', ('mail_error.png', b'\x89PNG\r\n\x1a\nerror-content', 'image/png'))]
    add_resp = accounts.cust_1.post(f'/api/cases/{case_id}/attachments', files=files)
    assert add_resp.status_code == 200
    updated_case = add_resp.json()
    assert len(updated_case['ticket']['attachments']) == 1
    assert updated_case['ticket']['attachments'][0]['filename'] == 'mail_error.png'


def _ai_result(**extra):
    from realapp.models import VisualAnalysisPayload, ImageFinding
    return VisualAnalysisPayload(analysis_source='Gemini Multimodal Vision (test-model)', summary='Outlook crash dialog on Windows 11.',
                                 visual_observations='Outlook shows a crash dialog.', technical_diagnosis='Corrupt OST file, likely.',
                                 suggested_service='Outlook', suggested_category='Software', suggested_subcategory='Application Crash',
                                 recommended_action='Rebuild the Outlook profile.', application='Outlook 2021 (16.0.14332)',
                                 error_codes=['0x800CCC0E'], key_details=['Mailbox: j.smith@contoso.com'],
                                 images=[ImageFinding(file='crash.png', shows='Crash dialog over the inbox.', on_screen_text=['Microsoft Outlook has stopped working'], error_codes=['0x800CCC0E'])],
                                 **extra)


def _image_ticket(accounts):
    files = [('attachments', ('crash.png', b'\x89PNG\r\n\x1a\nvalid-test-content', 'image/png'))]
    created = accounts.cust_1.post('/api/customer/incidents', data={'short_description': 'Outlook keeps closing', 'description': 'Outlook closes when I open it.', 'service': 'General'}, files=files)
    assert created.status_code == 201, created.text
    return created.json()['id']


def test_staff_can_rerun_image_analysis_and_get_structured_findings(accounts, monkeypatch):
    case_id = _image_ticket(accounts)
    assert accounts.admin.get(f'/api/cases/{case_id}').json()['ticket']['visual_analysis']['analysis_source'].startswith('Demo')
    seen = {}
    def analyse(description, images):
        seen['files'] = [att.filename for att, _ in images]
        return _ai_result()
    monkeypatch.setattr(accounts.engine, 'analyze_visual', analyse)

    assert accounts.cust_1.post(f'/api/cases/{case_id}/image-analysis').status_code in {403, 404}   # customers can't
    result = accounts.tech_1.post(f'/api/cases/{case_id}/image-analysis')
    assert result.status_code == 200, result.text
    ticket = result.json()['ticket']
    assert seen['files'] == ['crash.png']                                    # the saved image was re-read
    va = ticket['visual_analysis']
    assert va['error_codes'] == ['0x800CCC0E'] and va['images'][0]['on_screen_text'] == ['Microsoft Outlook has stopped working']
    assert ticket['service'] == 'Outlook' and ticket['category'] == 'Software'  # real AI fills in default fields
    assert ticket['work_notes'][-1]['text'].startswith('Re-ran image analysis.\nImage analysed by Gemini')


def test_failed_rerun_keeps_the_earlier_result(accounts, monkeypatch):
    case_id = _image_ticket(accounts)
    monkeypatch.setattr(accounts.engine, 'analyze_visual', lambda d, i: _ai_result())
    assert accounts.admin.post(f'/api/cases/{case_id}/image-analysis').status_code == 200
    before = accounts.admin.get(f'/api/cases/{case_id}').json()['ticket']

    from realapp.models import VisualAnalysisPayload
    monkeypatch.setattr(accounts.engine, 'analyze_visual', lambda d, i: VisualAnalysisPayload(
        analysis_source='Keyword estimate (Local Extraction)', visual_observations='x', technical_diagnosis='y', recommended_action='z'))
    monkeypatch.setattr(type(accounts.engine), 'configured', property(lambda self: True))
    failed = accounts.admin.post(f'/api/cases/{case_id}/image-analysis')
    assert failed.status_code == 503 and "the AI service didn't respond" in failed.json()['detail']
    after = accounts.admin.get(f'/api/cases/{case_id}').json()['ticket']
    assert after['visual_analysis'] == before['visual_analysis'] and len(after['work_notes']) == len(before['work_notes'])
