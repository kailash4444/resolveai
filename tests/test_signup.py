from fastapi.testclient import TestClient

from realapp import main
from test_attachments import accounts  # noqa: F401  (fixture)

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
    assert refused.status_code == 403 and 'This is a customer account' in refused.json()['detail']
    assert client.get('/api/auth/status').json()['user'] is None             # and no session was created
    _, refused = sign_in(staff, 'customer')                                  # technician on the customer page
    assert refused.status_code == 403 and 'This is a technician or admin account' in refused.json()['detail']
    assert sign_in(admin, 'customer')[1].status_code == 403                  # admins use the staff page too
    assert sign_in(customer, None)[1].status_code == 422                     # the side is required
    assert sign_in(customer, 'customer')[1].json()['role'] == 'customer'
    assert sign_in(staff, 'technician')[1].json()['role'] == 'technician'
    assert sign_in(admin, 'technician')[1].json()['role'] == 'admin'
    old = TestClient(main.app).get('/staff/login', follow_redirects=False)                   # old address forwards
    assert old.status_code == 307 and old.headers['location'] == '/login?as=staff'
