from fastapi.testclient import TestClient

from test_calling import webapp  # noqa: F401  (fixture)


def _client(app, username, password, side='customer'):
    client = TestClient(app)
    assert client.post('/api/auth/login', json={'username': username, 'password': password, 'expected_role': side}).status_code == 200
    return client


def _setup(webapp):
    app, service = webapp
    admin = TestClient(app)
    admin.post('/api/auth/setup', json={'name': 'Admin', 'username': 'admin', 'password': 'test-admin-password'})
    for role, name in (('customer', 'casey'), ('customer', 'other'), ('technician', 'tara')):
        body = {'role': role, 'name': name.title(), 'username': name, 'password': f'{name}-password-1234', 'skills': ['general'], 'languages': ['en']}
        assert admin.post('/api/users', json=body).status_code == 201
    return app, service, admin


def test_customer_chat_runs_from_start_to_technician_reply_and_end(webapp):
    app, service, _ = _setup(webapp)
    casey = _client(app, 'casey', 'casey-password-1234')

    started = casey.post('/api/support/chats', json={'description': 'Outlook closes whenever I open the shared team calendar.'})
    assert started.status_code == 201
    chat = started.json()
    assert chat['transcript'][0] == {'speaker': 'Customer', 'text': 'Outlook closes whenever I open the shared team calendar.', 'timestamp': chat['transcript'][0]['timestamp']}
    # Starting returns at once with the assistant typing; triage and the first reply follow in the background.
    assert chat['status'] == 'Triage' and chat['agent_typing'] is True
    chat = casey.get(f"/api/support/chats/{chat['id']}").json()
    assert chat['status'] in {'AI', 'Queued'} and chat['ticket_number']

    # The chat and its incident belong to the customer who started it.
    case = service.case_store.get_case(chat['case_id'])
    casey_id = service.authenticate(casey.cookies.get('resolveai_session'))['id']
    assert case.customer_id == casey_id
    assert any(c['id'] == chat['id'] and c['channel'] == 'chat' for c in casey.get('/api/customer/calls').json())

    # Nobody else can read or write it.
    other = _client(app, 'other', 'other-password-1234')
    assert other.get(f"/api/support/chats/{chat['id']}").status_code == 404
    assert other.post(f"/api/support/chats/{chat['id']}/messages", json={'text': 'hi'}).status_code == 404

    assert casey.post(f"/api/support/chats/{chat['id']}/technician").json()['status'] == 'Queued'
    assert casey.post(f"/api/support/chats/{chat['id']}/messages", json={'text': 'It started after the update.'}).json()['transcript'][-1]['text'] == 'It started after the update.'

    tara = _client(app, 'tara', 'tara-password-1234', 'technician')
    tara_id = service.authenticate(tara.cookies.get('resolveai_session'))['id']
    service.presence(tara_id, 'Available')
    service.heartbeat(tara_id, False)
    assert tara.post(f"/api/calling/{chat['id']}/accept").status_code == 200
    assert service.get(chat['id'])['status'] == 'Connected'

    replied = tara.post(f"/api/calling/{chat['id']}/reply", json={'text': 'Please try signing out of Outlook and back in.'})
    assert replied.status_code == 200
    seen = casey.get(f"/api/support/chats/{chat['id']}").json()
    assert seen['transcript'][-1]['speaker'] == 'Technician' and seen['technician_name'] == 'Tara'

    assert casey.post(f"/api/support/chats/{chat['id']}/end").json()['status'] == 'Completed'
    assert casey.post(f"/api/support/chats/{chat['id']}/messages", json={'text': 'one more'}).status_code == 409


def test_technician_reply_requires_an_accepted_chat_and_customers_cannot_use_it(webapp):
    app, service, admin = _setup(webapp)
    casey = _client(app, 'casey', 'casey-password-1234')
    chat = casey.post('/api/support/chats', json={'description': 'The floor 3 printer shows offline for everyone.'}).json()

    # Customers are blocked from staff calling routes by the API guard.
    assert casey.post(f"/api/calling/{chat['id']}/reply", json={'text': 'x'}).status_code == 403
    # Staff can only reply once the chat is connected to them (or as admin, once connected).
    assert admin.post(f"/api/calling/{chat['id']}/reply", json={'text': 'Hello'}).status_code == 409
    # Starting a chat validates input.
    assert casey.post('/api/support/chats', json={'description': 'short'}).status_code == 422


def test_assistant_answers_first_hands_off_with_the_incident_number_and_shows_typing(webapp):
    app, service, _ = _setup(webapp)
    casey = _client(app, 'casey', 'casey-password-1234')
    chat = casey.post('/api/support/chats', json={'description': 'My VPN keeps disconnecting every few minutes, how do I fix it?'}).json()
    # The assistant answers first (its reply arrives after the customer's message), then may hand off to a person.
    chat = casey.get(f"/api/support/chats/{chat['id']}").json()
    assert chat['transcript'][1]['speaker'] == 'AI Agent' and chat['status'] in {'AI', 'Queued'}
    assert chat['agent_typing'] is False

    # Typing signals travel both ways and stop when a message is sent.
    assert casey.post(f"/api/support/chats/{chat['id']}/typing").status_code == 200
    tara = _client(app, 'tara', 'tara-password-1234', 'technician')
    seen = lambda: next(c for c in tara.get('/api/calling').json()['calls'] if c['id'] == chat['id'])
    admin_view = TestClient(app)
    admin_view.post('/api/auth/login', json={'username': 'admin', 'password': 'test-admin-password', 'expected_role': 'technician'})
    assert next(c for c in admin_view.get('/api/calling').json()['calls'] if c['id'] == chat['id'])['customer_typing'] is True
    casey.post(f"/api/support/chats/{chat['id']}/messages", json={'text': 'Still dropping.'})
    assert next(c for c in admin_view.get('/api/calling').json()['calls'] if c['id'] == chat['id'])['customer_typing'] is False

    # Asking for a person queues the chat and tells the customer their incident number.
    handed = casey.post(f"/api/support/chats/{chat['id']}/technician").json()
    assert handed['status'] == 'Queued'
    assert any(turn['speaker'] == 'AI Agent' and handed['ticket_number'] in turn['text'] for turn in handed['transcript'])


def test_chats_are_never_offered_to_a_technician_who_is_on_a_call(webapp):
    app, service, _ = _setup(webapp)
    tara_id = next(t['id'] for t in service.snapshot()['technicians'] if t['username'] == 'tara')
    service.presence(tara_id, 'Available'); service.heartbeat(tara_id, False)
    busy = service.create_call('Caller', origin='desk')
    service.repository.mutate(lambda db: (db['calls'][busy['id']].update(status='Connected', technician_id=tara_id),
                                          db['technicians'][tara_id].update(status='Busy', current_call_id=busy['id'])))
    casey = _client(app, 'casey', 'casey-password-1234')
    chat = casey.post('/api/support/chats', json={'description': 'I need a technician to look at my laptop screen flickering.'}).json()
    casey.post(f"/api/support/chats/{chat['id']}/technician")
    service.dispatch()
    assert service.get(chat['id'])['technician_id'] != tara_id and service.get(chat['id'])['status'] == 'Queued'
