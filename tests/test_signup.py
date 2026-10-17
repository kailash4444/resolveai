from fastapi.testclient import TestClient

from realapp import main
from test_attachments import accounts  # noqa: F401  (fixture)
from test_calling import webapp  # noqa: F401  (fixture)

NEW = {'name': 'Priya Shah', 'username': 'priya.shah', 'password': 'correct horse battery'}


def test_sign_up_creates_a_signed_in_customer_and_never_staff(accounts):
    visitor = TestClient(main.app)
    assert visitor.get('/api/auth/status').json()['signup_enabled'] is True
    created = visitor.post('/api/auth/register', json={**NEW, 'role': 'admin'})   # a role in the request is ignored
    assert created.status_code == 201, created.text
    assert created.json()['role'] == 'customer' and created.json()['username'] == 'priya.shah'
    assert visitor.get('/api/auth/status').json()['user']['id'] == created.json()['id']   # signed in straight away
    assert visitor.get('/api/customer/calls').status_code == 200
    assert visitor.get('/api/users').status_code == 403                                     # customer, not staff

    again = TestClient(main.app)
    assert again.post('/api/auth/login', json={'username': 'Priya.Shah', 'password': NEW['password'], 'expected_role': 'customer'}).status_code == 200
    assert again.post('/api/auth/register', json=NEW).status_code == 409                    # username taken


def test_sign_up_rejects_weak_details(accounts):
    visitor = TestClient(main.app)
    assert visitor.post('/api/auth/register', json={**NEW, 'password': 'short'}).status_code == 422
    assert visitor.post('/api/auth/register', json={**NEW, 'username': 'has space'}).status_code == 422
    weak = visitor.post('/api/auth/register', json={**NEW, 'username': 'sam.lee', 'password': 'sam.lee-password-2026'})
    assert weak.status_code == 422 and 'username' in weak.json()['detail']


def test_sign_up_can_be_turned_off_and_is_rate_limited(accounts, monkeypatch):
    visitor = TestClient(main.app)
    monkeypatch.setattr(main.settings, 'allow_customer_signup', False)
    assert visitor.get('/api/auth/status').json()['signup_enabled'] is False
    assert visitor.post('/api/auth/register', json=NEW).status_code == 403
    monkeypatch.setattr(main.settings, 'allow_customer_signup', True)
    monkeypatch.setattr(main.settings, 'signups_per_hour_per_address', 0)
    assert visitor.post('/api/auth/register', json=NEW).status_code == 429


def test_customer_and_staff_sign_in_are_separate(accounts):
    customer = {'username': 'cust_1', 'password': 'isolated-user-password'}
    staff = {'username': 'tech_1', 'password': 'isolated-user-password'}
    admin = {'username': 'admin', 'password': 'isolated-admin-password'}
    def sign_in(value, side):
        client = TestClient(main.app)
        return client, client.post('/api/auth/login', json={**value, 'expected_role': side} if side else value)

    client, refused = sign_in(customer, 'technician')                      # customer on the staff page
    assert refused.status_code == 401 and refused.json()['detail'] == 'Incorrect email or password.'
    assert client.get('/api/auth/status').json()['user'] is None             # and no session was created
    _, refused = sign_in(staff, 'customer')                                  # technician on the customer page
    assert refused.status_code == 401 and refused.json()['detail'] == 'Incorrect email or password.'
    assert sign_in(admin, 'customer')[1].status_code == 401                  # admins use the staff page too
    assert sign_in(customer, None)[1].status_code == 422                     # the side is required
    assert sign_in(customer, 'customer')[1].json()['role'] == 'customer'
    assert sign_in(staff, 'technician')[1].json()['role'] == 'technician'
    assert sign_in(admin, 'technician')[1].json()['role'] == 'admin'
    old = TestClient(main.app).get('/staff/login', follow_redirects=False)                   # old address forwards
    assert old.status_code == 307 and old.headers['location'] == '/login?as=staff'


def test_sign_up_with_email_and_log_in_with_email_or_username(accounts):
    visitor = TestClient(main.app)
    created = visitor.post('/api/auth/register', json={'name': 'Ana Ruiz', 'email': 'Ana.Ruiz@Gmail.com', 'password': 'blue kettle on the stove'})
    assert created.status_code == 201, created.text
    assert created.json()['email'] == 'ana.ruiz@gmail.com' and created.json()['username'] == 'ana.ruiz@gmail.com'
    for ident in ('ANA.RUIZ@gmail.com', 'ana.ruiz@gmail.com'):
        assert TestClient(main.app).post('/api/auth/login', json={'username': ident, 'password': 'blue kettle on the stove', 'expected_role': 'customer'}).status_code == 200
    wrong = TestClient(main.app).post('/api/auth/login', json={'username': 'ana.ruiz@gmail.com', 'password': 'not the password', 'expected_role': 'customer'})
    assert wrong.status_code == 401 and wrong.json()['detail'] == 'Incorrect email or password.'
    assert visitor.post('/api/auth/register', json={'name': 'Ana Two', 'email': 'ana.ruiz@gmail.com', 'password': 'another long password'}).status_code == 409
    bad = visitor.post('/api/auth/register', json={'name': 'No Email', 'email': 'not-an-email', 'password': 'another long password'})
    assert bad.status_code == 422
    assert visitor.post('/api/auth/register', json={'name': 'No Email', 'password': 'another long password'}).status_code == 422
    weak = visitor.post('/api/auth/register', json={'name': 'Kim Lee', 'email': 'kimlee@company.com', 'password': 'kimlee-password-2026'})
    assert weak.status_code == 422 and 'email' in weak.json()['detail']


def test_staff_with_a_work_email_log_in_with_it(accounts):
    value = {'name': 'Ravi Kumar', 'username': 'ravi.k', 'email': 'Ravi.Kumar@Contoso.com', 'password': 'isolated-user-password', 'role': 'technician'}
    created = accounts.admin.post('/api/users', json=value)
    assert created.status_code == 201, created.text and created.json()['email'] == 'ravi.kumar@contoso.com'
    for ident in ('ravi.kumar@contoso.com', 'ravi.k'):
        signed_in = TestClient(main.app).post('/api/auth/login', json={'username': ident, 'password': value['password'], 'expected_role': 'technician'})
        assert signed_in.status_code == 200 and signed_in.json()['role'] == 'technician'
    # Emails and usernames share one namespace, so a login always finds exactly one account.
    assert accounts.admin.post('/api/users', json={**value, 'username': 'ravi.two'}).status_code == 409
    assert accounts.admin.post('/api/users', json={**value, 'username': 'ravi.three', 'email': 'tech_1@x.io'}).status_code == 201
    assert accounts.admin.post('/api/users', json={**value, 'username': 'ravi.kumar@contoso.com', 'email': ''}).status_code == 409
    assert accounts.admin.post('/api/users', json={**value, 'username': 'ravi.four', 'email': 'nope'}).status_code == 422


def test_only_administrators_see_and_manage_users_and_can_delete_technicians(webapp):
    from fastapi.testclient import TestClient
    app, service = webapp
    admin = TestClient(app)
    admin.post('/api/auth/setup', json={'name': 'Admin', 'username': 'admin', 'password': 'test-admin-password'})
    for name in ('tara', 'theo'):
        assert admin.post('/api/users', json={'role': 'technician', 'name': name.title(), 'username': name, 'password': f'{name}-password-1234',
                                              'skills': ['general'], 'languages': ['en']}).status_code == 201
    assert admin.post('/api/users', json={'role': 'customer', 'name': 'Casey', 'username': 'casey', 'password': 'casey-password-1234',
                                          'skills': ['general'], 'languages': ['en']}).status_code == 201
    ids = {u['username']: u['id'] for u in admin.get('/api/users').json()}
    tara = TestClient(app)
    assert tara.post('/api/auth/login', json={'username': 'tara', 'password': 'tara-password-1234', 'expected_role': 'technician'}).status_code == 200

    # Technicians can't list, add or delete users.
    assert tara.get('/api/users').status_code == 403
    assert tara.post('/api/users', json={'role': 'technician', 'name': 'Sneaky', 'username': 'sneaky', 'password': 'sneaky-password-123'}).status_code == 403
    assert tara.delete(f"/api/users/{ids['theo']}").status_code == 403

    # Admins can't delete themselves, other admins or customers here, nor a technician who is on a call.
    assert admin.delete(f"/api/users/{ids['admin']}").status_code == 409
    assert admin.delete(f"/api/users/{ids['casey']}").status_code == 409
    service.repository.mutate(lambda db: db['technicians'][ids['theo']].update(current_call_id='CALL-1'))
    assert admin.delete(f"/api/users/{ids['theo']}").status_code == 409
    assert admin.delete('/api/users/tech_missing').status_code == 404

    # Deleting a technician signs them out at once and they can't log in again.
    assert admin.delete(f"/api/users/{ids['tara']}").json()['name'] == 'Tara'
    assert tara.get('/api/calling').status_code == 401
    assert TestClient(app).post('/api/auth/login', json={'username': 'tara', 'password': 'tara-password-1234', 'expected_role': 'technician'}).status_code == 401
    assert 'tara' not in {u['username'] for u in admin.get('/api/users').json()}
