from fastapi.testclient import TestClient

from test_calling import webapp  # noqa: F401  (fixture)


def _client(app, username, password):
    client = TestClient(app)
    assert client.post('/api/auth/login', json={'username': username, 'password': password}).status_code == 200
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

    tara = _client(app, 'tara', 'tara-password-1234')
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
