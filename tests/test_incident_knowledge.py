import json
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from realapp import main
from realapp.config import Settings
from realapp.engine import OpenAIEngine
from realapp.gemini import GeminiEngine
from realapp.models import AnalysisRequest, KnowledgeContent, QAAuditPayload, WorkNote
from realapp.store import MemoryStore, SQLiteStore
from conftest import signed_in_admin


def incident(engine, channel='Voice'):
    case = engine.analyze(AnalysisRequest(channel=channel, transcript='Customer: The browser page stays blank.\nTechnician: Clear cached files and retry.'))
    case.ticket.work_notes = [
        WorkNote(id='H', author='Ticket history', author_type='System', text='EXCLUDED_HISTORY_MARKER'),
        WorkNote(id='T', author='Technician', author_type='Technician', text='Cleared cached files; page was blank and is now working.'),
        WorkNote(id='C', author='Customer', author_type='Customer', text='Confirmed the page works after signing in again.'),
    ]
    case.ticket.state = 'Resolved'
    case.ticket.resolution = 'Cleared cached files; customer confirmed the page loads.'
    return case


@pytest.fixture
def draft_app(monkeypatch):
    store = MemoryStore()
    engine = OpenAIEngine(Settings(llm_provider='mock'), store.list_knowledge)
    first = incident(engine)
    first.ticket.call_id = 'CALL-SOURCE'
    second = incident(engine, 'Uploaded transcript')
    second.ticket.state = 'In Progress'
    second.ticket.resolution = ''
    store.save_case(first); store.save_case(second)
    captured = []
    def generate(context):
        captured.append(json.loads(context))
        return KnowledgeContent(title='Restore blank browser pages', product='Browser', symptoms='Pages appear blank.',
            steps=['Clear cached files, as documented in the source incidents.', 'Retry and confirm the page loads.'],
            resolution='Page loads successfully after confirmation.', tags=['browser'])
    engine.draft_knowledge = generate
    monkeypatch.setattr(main, 'store', store)
    monkeypatch.setattr(main, 'engine', engine)
    monkeypatch.setattr(main.app.state, 'calling', SimpleNamespace(get=lambda call_id:{'case_id':first.id,
        'transcript':[{'speaker':'Customer','text':'LATEST_CALL_CONTEXT','timestamp':None}]}))
    return SimpleNamespace(client=signed_in_admin(TestClient(main.app)), store=store, engine=engine, first=first, second=second, captured=captured)


def test_multiple_incidents_include_all_sources_and_draft_is_reviewed_before_save(draft_app, tmp_path):
    env = draft_app
    before = len(env.store.list_knowledge())
    response = env.client.post('/api/knowledge/from-incidents', json={'ticket_numbers':[
        ' '+env.first.ticket.id.lower()+' ', env.second.ticket.id, env.first.ticket.id]})
    assert response.status_code == 200, response.text
    result = response.json()
    assert result['article']['source_ticket_ids'] == [env.first.ticket.id, env.second.ticket.id]
    assert len(result['sources']) == 2 and result['warnings']
    sources = env.captured[0]
    assert sources[0]['call_transcript'][0]['text'] == 'LATEST_CALL_CONTEXT'
    assert sources[0]['source_transcript'][0]['text'] == 'The browser page stays blank.'
    assert sources[1]['source_channel'] == 'Uploaded transcript'
    assert sources[0]['ticket']['resolution'] == env.first.ticket.resolution
    assert len(sources[0]['ticket']['work_notes']) == 2
    assert 'EXCLUDED_HISTORY_MARKER' not in json.dumps(sources)
    assert len(env.store.list_knowledge()) == before
    result['article']['title'] = 'Reviewed browser recovery'
    saved = env.client.post('/api/knowledge', json=result['article'])
    assert saved.status_code == 201
    assert saved.json()['title'] == 'Reviewed browser recovery'
    assert saved.json()['source_ticket_ids'] == result['article']['source_ticket_ids']
    durable = SQLiteStore(str(tmp_path/'knowledge.sqlite3'))
    from realapp.models import KnowledgeArticleInput
    article = durable.add_knowledge(KnowledgeArticleInput(**result['article']))
    assert next(a for a in durable.list_knowledge() if a.id == article.id).source_ticket_ids == result['article']['source_ticket_ids']


def test_missing_or_empty_incidents_do_not_generate_partial_article(draft_app):
    env = draft_app
    response = env.client.post('/api/knowledge/from-incidents', json={'ticket_numbers':[env.first.ticket.id, 'INC-NOT-FOUND']})
    assert response.status_code == 404 and 'INC-NOT-FOUND' in response.json()['detail']
    assert not env.captured
    for numbers in ([], [' '], ['INC-X']*21):
        assert env.client.post('/api/knowledge/from-incidents', json={'ticket_numbers':numbers}).status_code == 422


def test_model_failure_keeps_knowledge_unchanged(draft_app):
    env = draft_app
    before = len(env.store.list_knowledge())
    def fail(context): raise ValueError('private provider diagnostic')
    env.engine.draft_knowledge = fail
    response = env.client.post('/api/knowledge/from-incidents', json={'ticket_numbers':[env.first.ticket.id]})
    assert response.status_code == 502
    assert 'private provider diagnostic' not in response.text
    assert len(env.store.list_knowledge()) == before


@pytest.mark.parametrize('provider', ['openai', 'gemini'])
def test_qa_receives_only_comments_and_preserves_activity(provider):
    store = MemoryStore()
    case = incident(OpenAIEngine(Settings(llm_provider='mock'), store.list_knowledge))
    case.ticket.call_id = 'CALL-EXCLUDED-REFERENCE'
    case.ticket.assigned_to = 'EXCLUDED-ASSIGNEE'
    original = case.model_dump_json()
    engine = OpenAIEngine(Settings(llm_provider='openai'), store.list_knowledge) if provider == 'openai' else GeminiEngine(Settings(gemini_provider='google_ai'), store.list_knowledge)
    prompts = []
    def capture(*args):
        prompts.append('\n'.join(arg for arg in args if isinstance(arg, str)))
        return QAAuditPayload(checks=[], quality_score=95)
    engine._generate = capture
    engine.audit(case)
    assert 'EXCLUDED_HISTORY_MARKER' not in prompts[0]
    assert case.ticket.work_notes[1].text in prompts[0]
    assert case.ticket.work_notes[2].text in prompts[0]
    assert case.ticket.resolution in prompts[0]
    assert case.ticket.id not in prompts[0]
    assert case.ticket.call_id not in prompts[0]
    assert case.ticket.assigned_to not in prompts[0]
    ticket_context = json.loads(prompts[0].split('TICKET:\n')[1])
    assert not {'id','state','call_id','assigned_to','category','subcategory'}.intersection(ticket_context)
    assert ticket_context['category_and_subcategory'] == {'category':case.ticket.category,'subcategory':case.ticket.subcategory}
    assert case.model_dump_json() == original


def test_qa_schema_enforces_combined_classification_and_excludes_reference_fields():
    from pydantic import ValidationError
    from realapp.models import ScopedQACheck
    check = dict(result='PASS', observed='Access / Account', recommended='Keep classification', evidence='Account issue')
    assert ScopedQACheck(field='Category / Subcategory', **check).field == 'Category / Subcategory'
    for field in ('Category','Subcategory','State','id','call_id','assigned_to'):
        with pytest.raises(ValidationError):
            ScopedQACheck(field=field, **check)


def test_background_and_manual_audits_apply_comment_filter(draft_app):
    env = draft_app
    engine = OpenAIEngine(Settings(llm_provider='openai'), env.store.list_knowledge)
    prompts = []
    def capture(system, prompt, schema):
        prompts.append(prompt)
        return QAAuditPayload(checks=[], quality_score=90)
    engine._generate = capture
    env.engine.audit = engine.audit
    main.run_background_qa(env.first.id)
    assert env.client.post(f'/api/cases/{env.first.id}/qa').status_code == 200
    assert len(prompts) == 2 and all('EXCLUDED_HISTORY_MARKER' not in prompt for prompt in prompts)
    assert env.store.get_case(env.first.id).ticket.work_notes[0].text == 'EXCLUDED_HISTORY_MARKER'
