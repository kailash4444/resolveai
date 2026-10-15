from fastapi.testclient import TestClient

from realapp.main import app

client = TestClient(app)


def test_versioned_static_files_are_compressed_and_cached_for_a_year():
    response = client.get('/static/app.js?v=1', headers={'Accept-Encoding': 'gzip'})
    assert response.status_code == 200
    assert response.headers['content-encoding'] == 'gzip'
    assert response.headers['cache-control'] == 'public, max-age=31536000, immutable'


def test_unversioned_static_files_and_the_page_are_rechecked():
    assert client.get('/static/app.js').headers['cache-control'] == 'public, max-age=300'
    page = client.get('/', headers={'Accept-Encoding': 'gzip'})
    assert page.headers['cache-control'] == 'no-cache'
    assert page.headers['content-encoding'] == 'gzip'
