from concurrent.futures import ThreadPoolExecutor
import json
import re
import sqlite3

import pytest

from realapp.models import AnalysisRequest, KnowledgeArticleInput, KnowledgeMatch
from realapp.config import Settings
from realapp.engine import OpenAIEngine
from realapp.store import MemoryStore, SQLiteStore
from realapp.numbering import rewrite


def draft(store):
    return OpenAIEngine(Settings(llm_provider='mock'),store.list_knowledge).analyze(AnalysisRequest(transcript='Customer: My browser cannot open the report.'))


@pytest.mark.parametrize('backend',['memory','sqlite'])
def test_monotonic_numbers_under_concurrent_creation_and_stable_edits(tmp_path,backend):
    store=MemoryStore() if backend=='memory' else SQLiteStore(str(tmp_path/'records.sqlite3'))
    cases=[draft(store) for _ in range(24)]
    with ThreadPoolExecutor(max_workers=8) as pool: saved=list(pool.map(store.save_case,cases))
    assert sorted(c.ticket.id for c in saved)==[f'INC{i:07d}' for i in range(1,25)]
    chosen=saved[0];number=chosen.ticket.id
    chosen.ticket.id='INC-CLIENT-OVERRIDE';chosen.ticket.description='Edited description';store.save_case(chosen)
    assert chosen.ticket.id==number
    assert store.get_case(chosen.id).ticket.description=='Edited description'
    initial=len(store.list_knowledge())
    values=[KnowledgeArticleInput(title=f'Article {i}',product='Browser',symptoms='Blank page',steps=['Refresh'],resolution='Page displays') for i in range(12)]
    with ThreadPoolExecutor(max_workers=6) as pool: articles=list(pool.map(store.add_knowledge,values))
    assert sorted(a.id for a in articles)==[f'KB{i:05d}' for i in range(initial+1,initial+13)]
    article=articles[0];article.title='Revised article';updated=store.add_knowledge(article)
    assert updated.id==article.id and len(store.list_knowledge())==initial+12
    if backend=='sqlite':
        store=SQLiteStore(str(tmp_path/'records.sqlite3'))
        assert store.save_case(draft(store)).ticket.id=='INC0000025'


def test_legacy_migration_preserves_ownership_links_and_source_references(tmp_path):
    memory=MemoryStore();case=draft(memory)
    case.ticket.id='INC-DEMO-0001';case.customer_id='customer-id';case.ticket.assigned_user_id='tech-id'
    case.ticket.call_id='CALL-DEMO-0001';case.transcript[0].text='Follow incident INC-DEMO-0001 and article KB-OLD.'
    case.knowledge_matches=[KnowledgeMatch(id='KB-OLD',title='Old article',score=.9,excerpt='Guidance')]
    article=KnowledgeArticleInput(id='KB-OLD',title='Old article',product='Browser',symptoms='Blank',steps=['Refresh'],resolution='Page works',source_ticket_ids=['INC-DEMO-0001'])
    path=tmp_path/'legacy.sqlite3'
    with sqlite3.connect(path) as db:
        db.execute('CREATE TABLE cases (id TEXT PRIMARY KEY,body TEXT NOT NULL)')
        db.execute('CREATE TABLE knowledge (id TEXT PRIMARY KEY,body TEXT NOT NULL)')
        db.execute('INSERT INTO cases VALUES (?,?)',(case.id,case.model_dump_json()))
        db.execute('INSERT INTO knowledge VALUES (?,?)',(article.id,article.model_dump_json()))
    store=SQLiteStore(str(path));migrated=store.get_case(case.id);kb=store.list_knowledge()[0]
    assert migrated.ticket.id=='INC0000001' and kb.id=='KB00001'
    assert migrated.customer_id=='customer-id' and migrated.ticket.assigned_user_id=='tech-id'
    assert migrated.ticket.call_id=='CALL-DEMO-0001'
    assert kb.source_ticket_ids==['INC0000001'] and migrated.knowledge_matches[0].id=='KB00001'
    assert migrated.transcript[0].text=='Follow incident INC0000001 and article KB00001.'
    aliases=store.migrate_numbers()
    assert rewrite({'text':'See INC-DEMO-0001 and KB-OLD'},aliases)['text']=='See INC0000001 and KB00001'
    assert SQLiteStore(str(path)).get_case(case.id).ticket.id=='INC0000001'
