"""Admin CLI: python -m realapp.manage_knowledge_index --project ID --create-index --backfill."""
import argparse
import json


def ensure_cloud_index(settings):
    import google.auth
    from google.auth.transport.requests import AuthorizedSession
    credentials, _ = google.auth.default(scopes=['https://www.googleapis.com/auth/cloud-platform'])
    session = AuthorizedSession(credentials)
    url = (f'https://firestore.googleapis.com/v1/projects/{settings.google_cloud_project}/databases/(default)'
           f'/collectionGroups/{settings.firestore_collection}_knowledge_vectors/indexes')
    fields = [{'fieldPath': 'embedding_space', 'order': 'ASCENDING'},
              {'fieldPath': 'embedding', 'vectorConfig': {'dimension': settings.embedding_dimensions, 'flat': {}}}]
    page_token = None
    while True:
        response = session.get(url, params={'pageToken': page_token} if page_token else {}, timeout=30)
        response.raise_for_status()
        data = response.json()
        for index in data.get('indexes', []):
            actual = [f for f in index['fields'] if f['fieldPath'] != '__name__']
            if index.get('queryScope') == 'COLLECTION' and actual == fields:
                print('VECTOR_INDEX', index['name'], index['state'])
                return index
        page_token = data.get('nextPageToken')
        if not page_token:
            break
    response = session.post(url, json={'queryScope': 'COLLECTION', 'fields': fields}, timeout=30)
    response.raise_for_status()
    print('VECTOR_INDEX_OPERATION', response.json()['name'])
    return response.json()


def main():
    from realapp.config import Settings
    from realapp.gemini import GeminiEngine
    from realapp.store import create_store
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', help='GCP project; selects Firestore and Vertex AI with ADC')
    parser.add_argument('--create-index', action='store_true')
    parser.add_argument('--backfill', action='store_true')
    parser.add_argument('--query')
    args = parser.parse_args()
    settings = Settings()
    if args.project:
        settings.google_cloud_project = args.project
        settings.data_backend = 'firestore'
        settings.llm_provider = settings.gemini_provider = 'vertex'
    if args.create_index:
        if settings.data_backend != 'firestore':
            parser.error('--create-index requires Firestore (use --project).')
        ensure_cloud_index(settings)
    store = create_store(settings)
    engine = GeminiEngine(settings, store.list_knowledge)
    if not engine.knowledge_index:
        parser.error('A configured Google embedding provider is required.')
    if args.backfill:
        print('BACKFILL', json.dumps(engine.knowledge_index.sync_all(strict=True)))
    if args.query:
        print('MATCHES', json.dumps([{'id': m.id, 'title': m.title, 'score': m.score}
                                    for m in engine.retrieve(args.query)]))


if __name__ == '__main__':
    main()
